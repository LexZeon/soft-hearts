import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { _electron as electron } from 'playwright';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Acquire the native/build lease first. Uses an existing build, disposable Gene
// profile and public loopback replies; no real device, audio, cloud or user data.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR || workspace);
const output = path.join(workspace, '.local/reply-waiting-smoke');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-reply-waiting-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile); await mkdir(output, { recursive: true });
const checks = [], errors = [], requests = [], identities = [], timings = {};
let instance, controls, pet, bubble, report, phase = 'launch';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
async function poll(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs). Each turn is held open and driven
// below with delta()/finish(); a stop, new conversation, character or model change cancels it (record.aborted).
const claude = await createClaudeFixture({ root: temporary, respond: turn => {
  const prompt = turn.currentUser;
  assert.equal(typeof prompt, 'string'); assert.match(prompt, /^WAIT_[A-Z_]+$/);
  for (const message of turn.history) {
    assert.equal(typeof message.content, 'string');
    assert.doesNotMatch(message.content, /reply-waiting|正在等待回复/);
    if (message.role === 'assistant') assert.ok(message.content.trim(), 'dots never become an empty assistant history message');
  }
  assert.doesNotMatch(turn.text, /reply-waiting|正在等待回复/);
  const record = { prompt, turn, marker: turn.text.match(/<sh-state-[a-f0-9]+>/)?.[0], completed: false, aborted: false };
  requests.push(record); turn.onCancel(() => { record.aborted = !record.completed; });
} });
// Claude Code's stream has no separate reasoning field: an omitted `content` sends nothing.
function delta(record, content) { if (content !== undefined) record.turn.delta(content); }
function finish(record) { record.completed = true; record.turn.done(); }
const native = () => instance.evaluate(({ BrowserWindow }) => {
  const windows = BrowserWindow.getAllWindows(), owner = windows.find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'));
  const reply = windows.find(win => win.webContents.getURL().endsWith('#soft-hearts-reply'));
  return { owner: owner && { visible: owner.isVisible(), bounds: owner.getBounds() }, reply: reply && { visible: reply.isVisible(), bounds: reply.getBounds(), focusable: reply.isFocusable() }, remote: globalThis.__waitingRemote };
});
const visible = async () => Boolean((await native()).reply?.visible);
const idle = () => poll(() => controls.evaluate(() => document.getElementById('stop-chat').classList.contains('hidden')), 'chat idle');
const dots = page => page.evaluate(() => [...document.querySelectorAll('.reply-waiting')].map(node => ({ count: node.children.length, text: node.textContent, role: node.getAttribute('role'), label: node.getAttribute('aria-label') })));
async function assertDots(page) {
  const state = await dots(page); assert.equal(state.length, 1);
  assert.deepEqual(state[0], { count: 3, text: '', role: 'status', label: '正在等待回复' });
}
async function noDots() {
  await poll(async () => (await dots(controls)).length === 0 && (await dots(pet)).length === 0 && (!await visible() || (await dots(bubble)).length === 0), 'all waiting dots removed');
}
async function start(prompt, page = controls) {
  phase = prompt; await idle();
  await page.evaluate(value => { document.getElementById('chat-input').value = value; document.getElementById('chat-form').requestSubmit(); }, prompt);
  await poll(() => requests.some(record => record.prompt === prompt), 'actual loopback request');
  assert.equal(requests.filter(record => record.prompt === prompt).length, 1, 'one request across both windows');
  const record = requests.find(record => record.prompt === prompt);
  await poll(async () => {
    const [a, b] = await Promise.all([controls, pet].map(frame => frame.evaluate(() => window.__waitingIds.at(-1))));
    if (!a || a !== b || identities.includes(a)) return false;
    identities.push(a); record.id = a; return true;
  }, 'same new accepted identity in both windows');
  await poll(() => { bubble = instance.windows().find(frame => frame.url().endsWith('#soft-hearts-reply')); return bubble; }, 'native reply surface');
  await poll(async () => await visible() && (await dots(controls)).length === 1 && (await dots(pet)).length === 1 && (await dots(bubble)).length === 1, 'accepted waiting painted in both windows');
  return record;
}
async function body(text) {
  await poll(async () => await visible() && await bubble.evaluate(expected => document.getElementById('reply-body').textContent === expected, text), 'first native body');
  await noDots();
}
async function shortTail() {
  const geometry = await bubble.evaluate(() => {
    const node = document.getElementById('reply-body'), rect = node.getBoundingClientRect(), tail = document.getElementById('reply-tail');
    const tip = { x: Number(tail.dataset.tipX), y: Number(tail.dataset.tipY) };
    const cornerX = node.dataset.side === 'right' ? rect.x : rect.right;
    const depth = node.dataset.above === 'true' ? tip.y - rect.bottom : rect.y - tip.y;
    return { width: rect.width, height: rect.height, depth, cornerOffset: Math.abs(tip.x - cornerX) };
  });
  assert.ok(Math.abs(geometry.depth - 10) < 1.1, 'waiting and body tails have bounded ten-DIP depth');
  assert.ok(geometry.cornerOffset <= 8, 'short tail stays beside the body corner');
  assert.ok((await native()).reply.bounds.width <= geometry.width + 18, 'native bounds do not span the mouth gap');
  return geometry;
}
async function windowAction(kind, action) {
  await instance.evaluate(({ BrowserWindow }, value) => {
    const win = BrowserWindow.getAllWindows().find(item => /index\.html(?:\?|$)/.test(item.webContents.getURL()) && new URL(item.webContents.getURL()).searchParams.has('pet') === (value.kind === 'pet'));
    value.action === 'hide' ? win.hide() : win.showInactive();
  }, { kind, action });
}
async function clear() { await controls.evaluate(() => document.getElementById('new-chat').click()); await idle(); await noDots(); }
try {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, model: null, motion: null,
    provider: claude.provider, persona: 'Public synthetic waiting test companion.',
    pet: { visible: true, alwaysOnTop: true, clickThrough: false, scale: 1, followMouse: false, fps: 24 },
    voice: { enabled: false, voiceURI: '', rate: 1, volume: 0 }, tts: { provider: 'system', apiHost: '', apiKey: '', introduced: true } }));
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile }); delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  instance = await electron.launch({ ...(process.env.MMD_TEST_EXE ? { executablePath: path.resolve(process.env.MMD_TEST_EXE), args: [`--user-data-dir=${profile}`] } : { args: [appDirectory, `--user-data-dir=${profile}`] }), cwd: appDirectory, env });
  await claude.install(instance);
  await instance.firstWindow();
  await poll(() => {
    controls = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'two trusted windows');
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
  // Chat runs through the fake Claude Code process, so no HTTP is allowed at all.
  await instance.evaluate(({ session }) => {
    globalThis.__waitingRemote = [];
    globalThis.fetch = () => { globalThis.__waitingRemote.push('blocked host fetch'); throw new Error('External fixture request blocked'); };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__waitingRemote.push('blocked renderer request'); callback({ cancel: true }); });
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  });
  for (const page of [controls, pet]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#chat-input');
    await page.evaluate(() => { window.__waitingIds = []; window.__waitingEvents = []; window.desktop.onChatStarted(chat => window.__waitingIds.push(chat.id)); window.desktop.onStream(event => window.__waitingEvents.push(event)); });
  }
  await controls.evaluate(() => window.desktop.useBundledModel());
  await poll(() => pet.evaluate(() => /模型已就绪|VMD 播放中/.test(document.getElementById('pet-status').textContent)), 'Gene rendered', 30000);
  await navigateControlPage(controls, 'chat'); await clear();
  const first = await start('WAIT_FIRST');
  await poll(async () => await visible() && (await dots(bubble)).length === 1, 'native waiting is visible');
  for (const page of [controls, pet, bubble]) await assertDots(page);
  assert.ok(await controls.evaluate(id => window.__waitingEvents.some(event => event.id === id && event.type === 'status'), first.id), 'status is not body');
  const geometry = await shortTail();
  assert.equal(geometry.width, 72); assert.equal(geometry.height, 44); assert.equal((await native()).reply.focusable, false);
  await bubble.screenshot({ path: path.join(output, 'waiting-bubble.png'), omitBackground: true });
  await controls.locator('.message.assistant').last().screenshot({ path: path.join(output, 'waiting-controls.png') });
  await bubble.emulateMedia({ reducedMotion: 'no-preference' });
  const animation = await bubble.evaluate(() => { window.__waitingNodes = [...document.querySelectorAll('.reply-waiting-dot')]; window.__waitingAnimations = window.__waitingNodes.map(node => node.getAnimations()[0]); return window.__waitingNodes.map(node => ({ name: getComputedStyle(node).animationName, delay: getComputedStyle(node).animationDelay })); });
  assert.ok(animation.every(item => item.name === 'soft-hearts-reply-wait')); assert.deepEqual(animation.map(item => item.delay), ['0s', '0.15s', '0.3s']);
  await pause(350);
  assert.ok(await bubble.evaluate(() => [...document.querySelectorAll('.reply-waiting-dot')].every((node, index) => node === window.__waitingNodes[index] && node.getAnimations()[0] === window.__waitingAnimations[index])), 'anchor paints preserve nodes and animations');
  await bubble.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await bubble.evaluate(() => [...document.querySelectorAll('.reply-waiting-dot')].every(node => getComputedStyle(node).animationName === 'none')));
  await bubble.emulateMedia({ reducedMotion: 'no-preference' });
  delta(first, ' \n'); // (The retired OpenAI fixture also sent a reasoning-only delta here; Claude Code's stream has none.)
  await pause(5200); for (const page of [controls, pet, bubble]) await assertDots(page); assert.equal(await visible(), true);
  check('one accepted request drives both renderers and a compact native wait beyond five seconds; status/whitespace/reasoning are not body');
  check('three sequential animations remain stable across anchor paints and reduced motion is static');
  delta(first, '公开测试正文。'); await body(' \n公开测试正文。'); await shortTail(); assert.equal(first.completed, false);
  finish(first); await idle(); const completeAt = Date.now(); await pause(4200); assert.equal(await visible(), true);
  await poll(async () => !await visible(), 'five seconds after completion', 2500); timings.completeExpiryMs = Date.now() - completeAt;
  assert.ok(timings.completeExpiryMs >= 4850 && timings.completeExpiryMs < 7000); check('first visible body replaces dots before completion and existing five-second reply expiry remains');
  const cancelled = await start('WAIT_CANCEL'); await assertDots(controls); await controls.evaluate(() => document.getElementById('stop-chat').click()); await idle(); await noDots();
  await poll(() => cancelled.aborted, 'provider cancellation'); check('stop removes waiting and cancels its one actual request');
  // A whitespace-only Claude reply is an error in the app ("Claude 没有返回文字"), covered by WAIT_ERROR below.
  for (const mode of ['METADATA']) {
    await clear(); const record = await start('WAIT_' + mode); await assertDots(bubble);
    assert.ok(record.marker); delta(record, record.marker + '{"context":"neutral","delta":{},"reason":"public fixture","confidence":0.99,"gesture":"none"}' + record.marker.replace('<', '</'));
    await pause(150); await assertDots(bubble); finish(record); await idle(); await noDots(); assert.equal(await visible(), false);
  }
  check('metadata-only completed reply removes waiting without fabricated text');
  await clear(); const failed = await start('WAIT_ERROR'); failed.completed = true; failed.turn.fail('PUBLIC_FIXTURE_FAILURE'); await idle(); await noDots();
  await poll(() => controls.evaluate(() => document.querySelector('.message-error')?.textContent.includes('PUBLIC_FIXTURE_FAILURE')), 'existing error remains readable'); check('Claude failure removes waiting and retains the existing error display');
  for (const mode of ['NEW_CHAT', 'CARD', 'PROVIDER']) {
    await clear(); const record = await start('WAIT_' + mode);
    if (mode === 'NEW_CHAT') await clear();
    if (mode === 'CARD') await controls.evaluate(async () => { const state = await window.desktop.saveCharacterCard({ name: 'Public alternate fixture', systemPrompt: 'Public test companion.' }); await window.desktop.activateCharacterCard(state.cards.at(-1).id); });
    if (mode === 'PROVIDER') await controls.evaluate(async () => { const settings = await window.desktop.getSettings(); settings.provider.model = 'sonnet'; await window.desktop.saveSettings(settings); });
    await idle(); await noDots(); await poll(() => record.aborted, mode + ' cancels old request');
  }
  check('new conversation, character and provider changes clear old accepted waiting');
  await clear(); const hidden = await start('WAIT_HIDE'); await assertDots(bubble); await windowAction('pet', 'hide'); await poll(async () => !await visible(), 'hide clears native waiting');
  delta(hidden, ' \n'); await windowAction('pet', 'show'); await pause(300); assert.equal(await visible(), false); assert.equal((await dots(pet)).length, 0); finish(hidden); await idle();
  check('hide plus late blank and restore never revives the same waiting identity');
  await clear(); const background = await start('WAIT_CONTROLS_HIDE'); await windowAction('controls', 'hide'); await pause(150); await assertDots(pet); await assertDots(bubble); assert.equal(await visible(), true);
  delta(background, '后台公开测试正文。'); await body('后台公开测试正文。'); finish(background); await idle(); await windowAction('controls', 'show');
  check('hiding controls does not stop the pet waiting or its first body');
  await clear(); const beforeRaceRequests = requests.length;
  await controls.evaluate(async () => {
    const state = await window.desktop.getCharacterCards(), channel = new BroadcastChannel('soft-hearts-chat');
    channel.postMessage({ type: 'clear', cancelledId: 'late-fixture', context: `${state.revision ?? 0}:${state.activeId}` });
    await new Promise(resolve => setTimeout(resolve, 150)); channel.close();
  });
  await instance.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows().filter(item => /index\.html(?:\?|$)/.test(item.webContents.getURL()))) {
      win.webContents.send('desk:chat-started', { id: 'late-fixture', owner: 'controls', messages: [{ role: 'user', content: '公开迟到夹具。' }] });
      win.webContents.send('desk:stream', { id: 'late-fixture', kind: 'chat', type: 'delta', text: 'LATE_BODY_MUST_NOT_APPEAR' });
      win.webContents.send('desk:stream', { id: 'late-fixture', kind: 'chat', type: 'done', text: '' });
    }
  });
  await pause(300); await noDots(); assert.equal(await visible(), false); assert.equal(requests.length, beforeRaceRequests);
  assert.equal(await controls.evaluate(() => document.getElementById('messages').textContent.includes('LATE_BODY_MUST_NOT_APPEAR')), false);
  check('controlled clear-before-start race tombstones the late accepted identity without a backend request');
  const cards = await controls.evaluate(() => window.desktop.getCharacterCards()); assert.doesNotMatch(JSON.stringify(cards), /reply-waiting|正在等待回复/);
  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState()); assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false);
  assert.deepEqual((await native()).remote, []); assert.deepEqual(errors, []); assert.equal(new Set(identities).size, requests.length);
  claude.assertClean([claude.model, 'sonnet']); assert.deepEqual((await claude.evidence(instance)).denied, []);
  check('no dot text in request history or cards, no duplicate requests, no external service or capture');
  report = { ok: true };
} catch (error) { report = { ok: false, phase, failure: error.stack ?? String(error) }; console.error(error); process.exitCode = 1; }
finally {
  if (instance) await instance.close().catch(error => { errors.push(`owned close: ${error.message}`); process.exitCode = 1; });
  const fakeClaude = await claude.close();
  Object.assign(report ??= { ok: false }, { checks, errors, fakeClaude, timings, identities, requests: requests.map(({ prompt, id, completed, aborted }) => ({ prompt, id, completed, aborted })), limits: ['Controlled Electron/CDP input is not physical mouse/keyboard acceptance.', 'Speech remained disabled at volume zero; existing TTS playback regression is a separate smoke.', 'No desktop screenshots, private model, normal profile or physical devices used.'] });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const resolved = path.resolve(temporary); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('soft-reply-waiting-'));
  await rm(resolved, { recursive: true, force: true });
}
