import assert from 'node:assert/strict';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createHash } from 'node:crypto';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { armSmokeWatchdog, closeElectron } from './lib/electron-cleanup.mjs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Source mode runs this checkout's own build (`pnpm build` first); MMD_TEST_APP_DIR / MMD_TEST_EXE still select
// another build or a package. The Codex-era "separate frozen candidate only" rule belonged to its shared
// multi-agent workspace and native slot (2026-11-02 smoke triage). runtimeHashes() still proves the build
// under test did not change during the run.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = await realpath(path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace));
const output = path.join(workspace, '.local/mood-smoke');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const checked = [], screenshots = [], errors = [], requests = [], serverErrors = [];
const watched = new WeakSet();
const originalUser = '我们一起听原创音乐《纸风铃》，这是本次测试的共同经历。';
const originalReply = '这段关于《纸风铃》的原创音乐聊天让我觉得很亲近。';
const longReply = '原创长文片段：风从纸风铃旁经过。'.repeat(380);
const partialReply = '这是一段已经显示、随后由用户停止的原创回复。';
let instance, controls, pet, report, runtimeBefore;
// A failing or hung run still closes its own window (scripts/lib/electron-cleanup.mjs).
const disarm = armSmokeWatchdog(() => instance, 480_000, 'mood-smoke');
let phase = 'freeze-check';
let guardInstalled = false;
let chatSequence = 0;
let diagnostics;
const startedAt = Date.now();

const textContent = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs). `requests` keeps each turn's
// Chat Completions-style view (persona/turn context as "system", then history, then the user message).
const claude = await createClaudeFixture({ respond: async turn => {
  try {
    requests.push({ messages: turn.messages, opening: turn.opening });
    const user = turn.currentUser ?? '';
    const marker = turn.nonce('state');
    const tail = marker ? `\n<sh-state-${marker}>${JSON.stringify({ context: 'support', delta: { O: 2, E: 1 }, reason: '友好的原创测试聊天', confidence: 0.95 })}</sh-state-${marker}>` : '';
    if (user.includes('SMOKE_STOP')) {
      turn.delta(partialReply);
      const timer = setTimeout(() => turn.done(), 30_000);
      turn.onCancel(() => clearTimeout(timer));
      return;
    }
    const reply = user.includes('SMOKE_LONG') ? longReply : user === originalUser ? originalReply : '这是一条来自隔离本地服务的原创测试回复。';
    // Deliberately split the private marker across chunks as a real stream would.
    turn.delta(reply);
    if (tail) {
      await new Promise(resolve => setTimeout(resolve, 35));
      turn.delta(tail.slice(0, 17));
      await new Promise(resolve => setTimeout(resolve, 35));
      turn.delta(tail.slice(17));
    }
    turn.done();
  } catch (error) { serverErrors.push(String(error)); throw error; }
} });
const OTHER_CLAUDE_MODEL = 'sonnet';

async function runtimeHashes() {
  const files = [];
  if (process.env.MMD_TEST_EXE) {
    files.push(path.resolve(process.env.MMD_TEST_EXE));
    const asar = path.join(path.dirname(path.resolve(process.env.MMD_TEST_EXE)), 'resources/app.asar');
    try { await readFile(asar); files.push(asar); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    files.push(path.join(appDirectory, 'package.json'));
    for (const folder of ['dist', 'dist-electron']) {
      const root = path.join(appDirectory, folder);
      async function visit(directory) {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, item.name);
          if (item.isDirectory()) await visit(file);
          else if (/\.(?:js|cjs|mjs|css|html)$/i.test(item.name)) files.push(file);
        }
      }
      await visit(root);
    }
    assert.ok(files.some(file => file.endsWith('main.cjs')), 'candidate includes the frozen Electron runtime');
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
}
function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on('pageerror', error => errors.push({ kind: 'pageerror', text: error.message }));
  window.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) errors.push({ kind: 'console', text: message.text() });
  });
}
// Explicitly await IPC predicates; async waitForFunction can otherwise become prematurely truthy.
async function poll(window, predicate, arg, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await window.evaluate(predicate, arg)) return;
    await window.waitForTimeout(60);
  }
  throw new Error(`Timed out during ${phase}`);
}
async function mood(window = controls) { return window.evaluate(() => window.desktop.getMood()); }
async function phaseIs(expected) { await poll(pet, async expected => (await window.desktop.getMood()).snapshot.phase === expected, expected); }
async function sameWindows() {
  const [left, right] = await Promise.all([mood(), mood(pet)]);
  assert.equal(left.characterId, right.characterId);
  assert.equal(left.token, right.token);
  assert.equal(left.developerMode, right.developerMode);
  assert.equal(left.snapshot.phase, right.snapshot.phase);
  for (const channel of ['D', 'O', 'E', 'N', 'C']) assert.ok(Math.abs(left.snapshot.values[channel] - right.snapshot.values[channel]) < 0.1);
}
async function capture(window, selector, label) {
  // Only these app-local fixtures are allowed; never capture a desktop or full page.
  assert.ok(selector === '#stage' || selector === '.mood-panel');
  await window.locator(selector).screenshot({ path: path.join(output, `${label}.png`), omitBackground: true });
  screenshots.push(`${label}.png`);
}
async function remoteAttempts() {
  return instance && guardInstalled ? instance.evaluate(() => [...globalThis.__moodRemoteRequests]) : [];
}
async function newDialog() {
  await navigateControlPage(controls, 'chat');
  await controls.locator('#new-chat').click();
  await controls.waitForTimeout(200);
}
async function chat(text, stop = false) {
  const id = `mood-smoke-${++chatSequence}`;
  await controls.evaluate(async ({ id, text }) => {
    await window.desktop.chat({ id, messages: [{ role: 'user', content: text }], attachments: [] });
  }, { id, text });
  if (stop) {
    await poll(controls, id => window.__moodSmokeEvents.some(event => event.id === id && event.type === 'delta'), id);
    await controls.evaluate(id => window.desktop.cancel(id), id);
  }
  await poll(controls, id => window.__moodSmokeEvents.some(event => event.id === id && (event.type === 'done' || event.type === 'error')), id);
  return id;
}
async function streamText(id, window = controls) {
  return window.evaluate(id => window.__moodSmokeEvents.filter(event => event.id === id && event.type === 'delta').map(event => event.text).join(''), id);
}
async function memories(query) { return controls.evaluate(query => window.desktop.listMemories(query), query); }
async function recordFor(query) {
  await poll(controls, async query => (await window.desktop.listMemories({ query })).records.length > 0, query);
  const found = await memories({ query });
  assert.equal(found.records.length, 1, `one isolated record matches ${query}`);
  return controls.evaluate(id => window.desktop.readMemory(id), found.records[0].id);
}
async function projectedHead() {
  await poll(pet, () => {
    const value = document.querySelector('#stage canvas')?.dataset.interactionRegion;
    if (!value) return false;
    const region = JSON.parse(value), rect = document.querySelector('#stage').getBoundingClientRect();
    const finite = ['x', 'y', 'axisXX', 'axisXY', 'axisYX', 'axisYY', 'radius', 'referenceWidth', 'mouthX', 'mouthY', 'mouthRadius']
      .every(key => Number.isFinite(region[key]));
    const visible = (x, y) => x > 0 && y > 0 && x < rect.width && y < rect.height
      && rect.left + x < innerWidth && rect.top + y < innerHeight;
    return finite && rect.width > 0 && rect.height > 0 && region.radius >= 4 && region.referenceWidth >= 8 && region.mouthRadius > 0
      && Math.hypot(region.axisXX, region.axisXY) >= 4 && Math.hypot(region.axisYX, region.axisYY) >= 4
      && Math.abs(region.axisXX * region.axisYY - region.axisXY * region.axisYX) >= 4
      && visible(region.x, region.y) && visible(region.mouthX, region.mouthY);
  });
  return pet.evaluate(() => {
    const region = JSON.parse(document.querySelector('#stage canvas').dataset.interactionRegion);
    const rect = document.querySelector('#stage').getBoundingClientRect();
    const reserved = [...document.querySelectorAll('#pet-toolbar, #pet-size-panel, .pet-chat, [data-mood-ui]')]
      .map(element => element.getBoundingClientRect().toJSON()).filter(rect => rect.width > 0 && rect.height > 0);
    return { ...region, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, reserved };
  });
}
function headPoint(head, u = 0, v = 0) {
  return { x: head.left + head.x + head.axisXX * u + head.axisYX * v,
    y: head.top + head.y + head.axisXY * u + head.axisYY * v };
}
function usablePoint(head, point) {
  return point.x > Math.max(0, head.left) && point.x < Math.min(head.viewportWidth, head.left + head.width)
    && point.y > Math.max(0, head.top) && point.y < Math.min(head.viewportHeight, head.top + head.height)
    && head.reserved.every(rect => point.x < rect.left || point.x >= rect.right || point.y < rect.top || point.y >= rect.bottom);
}
function scalpStroke(head) {
  // Choose a visible interior ellipse row, keeping the whole real mouse stroke
  // outside UI reservations even when rua temporarily makes their paint hidden.
  const row = [0, -0.2, 0.2].find(v => Array.from({ length: 9 }, (_, i) => headPoint(head, (i - 4) * 0.1125, v))
    .every(point => usablePoint(head, point)));
  assert.notEqual(row, undefined, 'Recovered Gene must expose a usable scalp stroke in the actual viewport: ' + JSON.stringify(head));
  return u => headPoint(head, u, row);
}
async function drag(type, region) {
  await pet.evaluate(({ type, region }) => {
    const surface = document.querySelector('#stage');
    surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true,
      clientX: region.left + region.mouthX, clientY: region.top + region.mouthY,
      dataTransfer: window.__moodSnack }));
  }, { type, region });
}

async function launch() {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE;
  const options = process.env.MMD_TEST_EXE ? { executablePath: process.env.MMD_TEST_EXE, args: [] } : { args: [appDirectory] };
  options.args.push(`--user-data-dir=${profile}`, '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost');
  instance = await electron.launch({ ...options, cwd: appDirectory, env, timeout: 30_000 });
  await claude.install(instance);
  instance.on('window', watch);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), profile);
  // allowedOrigin is null: chat runs through the fake Claude Code process, so no HTTP origin is allowed.
  await instance.evaluate(async ({ session }, allowedOrigin) => {
    const key = Symbol.for('undici.globalDispatcher.1');
    await fetch('data:text/plain,mood-smoke-guard');
    const original = globalThis[key];
    if (!original?.dispatch) throw new Error('Node fetch dispatcher unavailable');
    globalThis.__moodRemoteRequests = [];
    globalThis.__moodPermissionRequests = [];
    globalThis[key] = { dispatch(options, handler) {
      if (String(options.origin) !== allowedOrigin) {
        globalThis.__moodRemoteRequests.push(String(options.origin) + options.path);
        handler.onError(new Error('MOOD_SMOKE_REMOTE_BLOCKED')); return false;
      }
      return original.dispatch(options, handler);
    } };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const remote = /^https?:/i.test(details.url) && new URL(details.url).origin !== allowedOrigin;
      if (remote) globalThis.__moodRemoteRequests.push(details.url);
      callback({ cancel: remote });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      globalThis.__moodPermissionRequests.push(permission); callback(false);
    });
  }, null);
  guardInstalled = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const window of instance.windows()) watch(window);
    controls = instance.windows().find(window => { try { const url = new URL(window.url()); return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet'); } catch { return false; } });
    pet = instance.windows().find(window => { try { const url = new URL(window.url()); return url.pathname.endsWith('/index.html') && url.searchParams.has('pet'); } catch { return false; } });
    if (controls && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(controls && pet, 'controls and companion windows exist');
  controls.setDefaultTimeout(15_000); pet.setDefaultTimeout(15_000);
  await controls.waitForFunction(() => typeof window.desktop?.getMood === 'function');
  await pet.waitForFunction(() => typeof window.desktop?.getMood === 'function');
  // A fresh profile starts with the preinstalled Gene: an ordinary start shows only the pet and keeps the
  // controls closed (electron/initial-controls.ts, R37), and a hidden controls window hides its mood panel.
  // Open it the way a user does, through the pet's settings button.
  await pet.locator('#open-controls').evaluate(button => button.click());
  await poll(controls, () => !document.hidden, undefined, 10_000);
  for (const window of [controls, pet]) await window.evaluate(() => {
    window.__moodSmokeEvents = [];
    window.__moodInputs = [];
    window.desktop.onStream(event => window.__moodSmokeEvents.push(event));
    const log = value => { window.__moodInputs.push({ at: performance.now(), ...value }); if (window.__moodInputs.length > 100) window.__moodInputs.shift(); };
    window.desktop.onMood(view => log({ type: 'host-state', token: view.token, phase: view.snapshot.phase }));
    for (const event of ['pointermove', 'pointerleave', 'blur', 'focus', 'visibilitychange', 'click', 'input', 'beforeinput', 'keydown'])
      window.addEventListener(event, value => log({ type: event, x: value.clientX, y: value.clientY, target: value.target?.id || value.target?.tagName }), true);
    const input = document.querySelector('#chat-input');
    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(input, 'value', { configurable: true,
      get() { return valueDescriptor.get.call(this); },
      set(value) { log({ type: 'draft-assignment', length: String(value).length, stack: new Error().stack?.split('\n').slice(0, 6).join('\n') }); valueDescriptor.set.call(this, value); },
    });
    new MutationObserver(() => log({ type: 'body-class', value: document.body.className })).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
  await controls.evaluate(async provider => {
    const settings = await window.desktop.getSettings();
    settings.provider = { ...settings.provider, ...provider };
    settings.voice.enabled = false;
    await window.desktop.saveSettings(settings);
    await window.desktop.useBundledModel();
  }, claude.provider);
  // Outside developer mode the pet status shows only 模型已就绪 for both a ready model and VMD playback
  // (R38 default immersive, src/main.ts updateStageStatus); the old wait required the developer text.
  await poll(pet, async () => (await window.desktop.getSettings()).model?.name === 'gene.pmx' && /模型已就绪|VMD 播放中/.test(document.querySelector('#pet-status')?.textContent ?? ''), undefined, 60_000);
  // Default legacy camera can crop Gene's forehead under the toolbar. Use the
  // public recovery action to establish a reproducible full-model fixture.
  await controls.evaluate(() => window.desktop.recoverPet());
  scalpStroke(await projectedHead());
}

try {
  runtimeBefore = await runtimeHashes();
  await launch();

  phase = '01-defaults-and-two-windows';
  const initial = await mood();
  assert.equal(initial.developerMode, false);
  assert.equal(initial.snapshot.lastInteractionAt, null);
  assert.deepEqual(initial.snapshot.values, { D: 50, O: 50, E: 50, N: 50, C: 50 });
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null });
  assert.equal((await controls.evaluate(() => window.desktop.getSystemAudioState())).active, false);
  assert.equal((await controls.evaluate(() => window.desktop.getSettings())).motion.name, 'stand.vmd');
  await sameWindows();
  checked.push('Gene + manual Stand, two-window state, developer/media/system-audio defaults');

  phase = '02-developer-parameters-and-control-boundary';
  await controls.evaluate(() => window.desktop.setMoodDeveloperMode(true));
  await controls.locator('.mood-panel').waitFor({ state: 'visible' });
  await pet.locator('.mood-companion').waitFor({ state: 'visible' });
  await controls.locator('.mood-parameters > summary').click();
  await controls.locator('.mood-advanced > summary').click();
  const changed = structuredClone(initial.parameters); changed.sensitivity.O = 1.25;
  await controls.locator('.mood-json').fill(JSON.stringify(changed));
  await controls.getByRole('button', { name: '应用参数', exact: true }).click();
  await poll(controls, async () => (await window.desktop.getMood()).parameters.sensitivity.O === 1.25);
  await controls.getByRole('button', { name: '恢复 Gene 参数', exact: true }).click();
  await poll(controls, async () => (await window.desktop.getMood()).parameters.sensitivity.O === 1);
  assert.equal((await mood()).snapshot.lastInteractionAt, null);
  const rejected = await controls.evaluate(async () => {
    const view = await window.desktop.getMood();
    try { await window.desktop.moodInteraction({ token: view.token, sessionId: 'control-forbidden', type: 'phase', phase: 'rua' }); return false; } catch { return true; }
  });
  assert.equal(rejected, true);
  await controls.locator('.mood-parameters > summary').click();
  await controls.locator('.mood-companion-body').evaluate(element => { element.scrollTop = 0; });
  await capture(controls, '.mood-panel', 'gene-state-panel');
  await controls.evaluate(() => window.desktop.setMoodDeveloperMode(false));
  checked.push('visible developer panel, real JSON apply/restore, no reward, controls interaction IPC rejected');

  phase = '03-real-pointer-rua-draft-and-static';
  await pet.bringToFront();
  const inputRect = await pet.locator('#chat-input').evaluate(element => element.getBoundingClientRect().toJSON());
  await pet.mouse.move(inputRect.left + inputRect.width / 2, inputRect.top + inputRect.height / 2);
  await pet.locator('#chat-input').fill('保留这份原创草稿');
  assert.equal(await pet.locator('#chat-input').inputValue(), '保留这份原创草稿');
  await pet.evaluate(() => document.activeElement?.blur());
  const head = await projectedHead(), stroke = scalpStroke(head), contact = stroke(0);
  await pet.mouse.move(contact.x, contact.y);
  await phaseIs('rua');
  assert.equal(await pet.evaluate(() => document.body.classList.contains('pet-interacting')), true);
  // The user corrected the rua timing (docs/mood/behavior-motion-implementation.md, 最新真人时序纠正): a scalp hit
  // responds at once and only the settings toolbar starts fading after 2 s of the same contact; the chat input is
  // not hidden. The old check expected .pet-chat to turn visibility:hidden immediately.
  assert.notEqual(await pet.locator('.pet-chat').evaluate(element => getComputedStyle(element).visibility), 'hidden');
  const beforeRua = (await mood()).snapshot.values.O;
  for (let i = 0; i < 24; i++) {
    const point = stroke(Math.sin(i * Math.PI / 4) * 0.45);
    await pet.mouse.move(point.x, point.y);
    await pet.waitForTimeout(80);
  }
  await poll(controls, async before => (await window.desktop.getMood()).snapshot.values.O > before + 0.2, beforeRua);
  await pet.waitForTimeout(500);
  const staticBefore = (await mood()).snapshot;
  await pet.waitForTimeout(1_100);
  const staticAfter = (await mood()).snapshot;
  assert.ok(staticAfter.values.O <= staticBefore.values.O + 0.01, 'static hover cannot keep earning');
  assert.equal(staticAfter.lastInteractionAt, staticBefore.lastInteractionAt);
  const feedback = await pet.locator('#stage canvas').evaluate(canvas => JSON.parse(canvas.dataset.moodFeedback));
  assert.ok(feedback.head.every(Number.isFinite));
  await capture(pet, '#stage', 'gene-rua-stage');
  const reservedInput = await pet.locator('#chat-input').evaluate(element => element.getBoundingClientRect().toJSON());
  assert.ok(reservedInput.width > 0 && reservedInput.height > 0, 'Hidden input retains its real reservation.');
  await pet.mouse.move(reservedInput.left + reservedInput.width / 2, reservedInput.top + reservedInput.height / 2);
  await phaseIs('idle');
  assert.equal(await pet.locator('#chat-input').inputValue(), '保留这份原创草稿');
  assert.notEqual(await pet.locator('.pet-chat').evaluate(element => getComputedStyle(element).visibility), 'hidden');
  const latestHead = await projectedHead(), repeatContact = scalpStroke(latestHead)(0), face = headPoint(latestHead, 0, 1.6);
  assert.ok(usablePoint(latestHead, face), 'The lower-face exclusion sample must be visible and outside reserved UI.');
  await pet.mouse.move(repeatContact.x, repeatContact.y); await phaseIs('rua');
  await pet.mouse.move(face.x, face.y); await phaseIs('idle');
  assert.equal(await pet.locator('[data-pet-interaction-cursor]').evaluate(element => element.hidden), true);
  assert.equal(await pet.locator('#chat-input').inputValue(), '保留这份原创草稿');
  assert.equal((await controls.evaluate(() => window.desktop.getSettings())).motion.name, 'stand.vmd');
  checked.push('actual mouse rua on visible projected scalp, UI reservation/draft restore, lower-face exclusion, static no reward, manual Stand preserved');

  phase = '04-datatransfer-cancel-ready-release-once';
  await pet.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'original-smoke-snack.png', { type: 'image/png' }));
    window.__moodSnack = transfer;
  });
  const mouth = await projectedHead();
  const beforeCancel = (await mood()).snapshot.values.D;
  await drag('dragenter', mouth);
  await phaseIs('food-wait');
  await pet.keyboard.press('Escape');
  await phaseIs('idle');
  assert.ok((await mood()).snapshot.values.D <= beforeCancel + 0.01);
  await drag('dragenter', mouth);
  for (let i = 0; i < 6; i++) { await pet.waitForTimeout(130); await drag('dragover', mouth); }
  await phaseIs('food-ready');
  const beforeFood = (await mood()).snapshot.values.D;
  await drag('drop', mouth);
  await phaseIs('food-eating');
  const accepted = (await mood()).snapshot;
  assert.ok(accepted.values.D > beforeFood + 1);
  await drag('drop', mouth);
  await pet.waitForTimeout(200);
  assert.ok((await mood()).snapshot.values.D <= accepted.values.D + 0.01);
  await phaseIs('idle');
  await sameWindows();
  checked.push('DataTransfer image cancellation, 650ms mouth preparation, release-only single reward, two-window consistency');

  phase = '05-chat-archive-private-tail-and-tags';
  await controls.bringToFront();
  await controls.evaluate(async () => {
    const config = await window.desktop.getMemoryConfig(); config.segmentTurns = 1;
    await window.desktop.setMemoryConfig(config);
  });
  const firstId = await chat(originalUser);
  assert.equal(await streamText(firstId), originalReply);
  assert.equal(await streamText(firstId, pet), originalReply);
  assert.ok(!((await streamText(firstId)).includes('<sh-state-')));
  const first = await recordFor('纸风铃');
  assert.deepEqual(first.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(first.messages[0].content, originalUser);
  assert.equal(first.messages[1].content, originalReply);
  assert.ok(first.messages.every(message => Number.isFinite(message.createdAt) && message.createdAt <= message.updatedAt && message.status === 'complete'));
  assert.ok(first.tags.includes('纸风铃') && first.tags.includes('音乐'));
  assert.ok(requests.at(-1).messages.some(message => textContent(message.content).includes('<sh-state-')));
  checked.push('streamed Claude Code chat (fake CLI), both originals/timestamps archived, generated title/tags, nonce tail stripped from both windows and memory');

  phase = '06-new-dialog-tag-ui-and-long-pagination';
  const total = (await memories()).total;
  await newDialog();
  assert.equal((await memories()).total, total);
  await navigateControlPage(controls, 'memory');
  await controls.locator('#memory-tag').selectOption('纸风铃');
  await controls.locator(`.memory-record[data-record-id="${first.id}"]`).click();
  await controls.waitForFunction(expected => document.querySelector('.memory-original')?.textContent === expected, originalUser);
  await controls.locator('#memory-title').fill('原创纸风铃经历');
  await controls.locator('#memory-tags').fill('纸风铃，音乐，原创测试');
  await controls.locator('#memory-save').click();
  await poll(controls, async id => (await window.desktop.readMemory(id)).title === '原创纸风铃经历', first.id);
  await chat('SMOKE_LONG 请展示这次原创长文分页测试。');
  const long = await recordFor('SMOKE_LONG');
  let offset = 0, assembled = '';
  do {
    const page = await controls.evaluate(({ id, offset }) => window.desktop.readMemory(id, { messageOffset: 1, messageLimit: 1, textOffset: offset, textLimit: 4_000 }), { id: long.id, offset });
    assert.equal(page.messages[0].role, 'assistant');
    assembled += page.messages[0].content;
    offset = page.messages[0].nextTextOffset;
  } while (offset !== undefined);
  assert.equal(assembled, longReply);
  checked.push('new dialog preserves archives, actual tag viewer and title/tag editing, complete long-message pagination');

  phase = '07-stop-keeps-partial-original-without-appraisal';
  await newDialog();
  const stoppedId = await chat('SMOKE_STOP 这是停止流式回复的原创测试。', true);
  const stopped = await recordFor('SMOKE_STOP');
  assert.equal(await streamText(stoppedId), partialReply);
  assert.equal(stopped.messages[1].content, partialReply);
  assert.equal(stopped.messages[1].status, 'stopped');
  assert.ok(!stopped.messages[1].content.includes('<sh-state-'));
  checked.push('cancelled SSE retains only displayed partial original with stopped status and no hidden tail');

  phase = '08-role-isolation-and-stale-token';
  const originalCards = await controls.evaluate(() => window.desktop.getCharacterCards());
  const oldToken = (await mood()).token;
  const created = await controls.evaluate(() => window.desktop.saveCharacterCard({ name: '原创烟测角色', description: '只用于隔离验收', personality: '温和', scenario: '', greeting: '', examples: '', systemPrompt: '' }));
  const role = created.cards.find(card => card.name === '原创烟测角色');
  assert.ok(role);
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), role.id);
  await poll(controls, async id => (await window.desktop.getMood()).characterId === id, role.id);
  assert.equal((await memories()).total, 0);
  assert.equal((await mood()).snapshot.lastInteractionAt, null);
  assert.equal(await pet.evaluate(async token => {
    try { await window.desktop.moodInteraction({ token, sessionId: 'late-generation', type: 'phase', phase: 'rua' }); return false; } catch { return true; }
  }, oldToken), true);
  await controls.evaluate(id => window.desktop.activateCharacterCard(id), originalCards.activeId);
  await poll(controls, async id => (await window.desktop.getMood()).characterId === id, originalCards.activeId);
  assert.ok((await memories({ tag: '纸风铃' })).total > 0);
  checked.push('new character has separate state/archive, old renderer generation rejected, original character archive returns');

  phase = '09-provider-memory-scope';
  await controls.evaluate(async model => {
    const settings = await window.desktop.getSettings(); settings.provider.model = model;
    await window.desktop.saveSettings(settings);
  }, OTHER_CLAUDE_MODEL);
  assert.equal((await memories()).total, 0);
  await controls.evaluate(async model => {
    const settings = await window.desktop.getSettings(); settings.provider.model = model;
    await window.desktop.saveSettings(settings);
  }, claude.model);
  assert.ok((await memories({ tag: '纸风铃' })).total > 0);
  await controls.evaluate(() => window.desktop.resetSettings());
  assert.equal((await memories()).total, 0, 'settings reset changes memory provider scope before returning');
  await controls.evaluate(async provider => {
    const settings = await window.desktop.getSettings();
    settings.provider = { ...settings.provider, ...provider };
    settings.voice.enabled = false;
    await window.desktop.saveSettings(settings);
  }, claude.provider);
  assert.ok((await memories({ tag: '纸风铃' })).total > 0, 'reset preserves the old archive without sending it to the new connection');
  checked.push('provider model scope does not implicitly expose another connection archive');

  phase = '10-recall-delete-and-context-clear';
  await newDialog();
  await chat('还记得我们一起听原创音乐《纸风铃》吗？');
  const recalledRequest = requests.at(-1);
  assert.ok(recalledRequest.messages.some(message => message.role === 'system' && textContent(message.content).includes('<private-memory-data>')));
  assert.ok(recalledRequest.messages.some(message => message.role === 'system' && textContent(message.content).includes(originalUser)));
  const withRecall = await memories({ tag: '纸风铃' });
  for (const record of withRecall.records) await controls.evaluate(id => window.desktop.deleteMemory(id), record.id);
  assert.equal((await memories({ tag: '纸风铃' })).total, 0);
  assert.equal(await controls.evaluate(async id => { try { await window.desktop.readMemory(id); return false; } catch { return true; } }, first.id), true);
  await poll(controls, () => document.querySelectorAll('#messages .message').length === 0);
  await chat('还记得原创音乐《纸风铃》吗？');
  const afterDelete = requests.at(-1);
  assert.ok(!afterDelete.messages.some(message => message.role === 'system' && textContent(message.content).includes('<private-memory-data>')));
  assert.ok(!afterDelete.messages.some(message => textContent(message.content).includes(originalUser)));
  assert.deepEqual(await remoteAttempts(), []);
  assert.deepEqual(await instance.evaluate(() => [...globalThis.__moodPermissionRequests]), []);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(errors, []);
  // Phase 09 resets settings, so the default Claude Code model (no --model, "") becomes current and the app prewarms
  // a process for it because this character has chat history (docs/claude/2026-11-02-persistent-claude.md).
  claude.assertClean([claude.model, OTHER_CLAUDE_MODEL, '']); assert.deepEqual((await claude.evidence(instance)).denied, []);
  assert.deepEqual(await runtimeHashes(), runtimeBefore, 'the tested runtime stayed frozen');
  checked.push('bounded prior-memory recall, deletion removes originals/index/context, no remote/media calls, frozen runtime unchanged');
  report = { status: 'PASS', phase, packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000), checked, screenshots,
    requestCount: requests.length, remoteRequests: [], errors, runtimeHashes: runtimeBefore,
    limits: ['Time/offline/clock and retry edge cases are covered by pure engine/host tests; this script never changes the system clock.',
      'File drag uses real DOM DataTransfer and the Gene projection; it does not claim Windows Explorer native drag/drop validation.',
      'Only the synthetic Claude Code (fake CLI) is called; no real Claude Code, ASR/TTS, camera, microphone or screen source is exercised.',
      'Crying is a candidate state; no usable tears resource is claimed.'] };
  console.log(JSON.stringify({ status: report.status, checked: checked.length, requestCount: requests.length, elapsedSeconds: report.elapsedSeconds }, null, 2));
} catch (error) {
  if (pet && !pet.isClosed()) {
    diagnostics = await pet.evaluate(() => ({ inputs: window.__moodInputs, body: document.body.className,
      feedback: document.querySelector('#mood-local-feedback')?.textContent, focused: document.hasFocus(),
      active: document.activeElement?.id, region: document.querySelector('#stage canvas')?.dataset.interactionRegion,
      stageFeedback: document.querySelector('#stage canvas')?.dataset.moodFeedback,
      toast: document.querySelector('#toast')?.textContent })).catch(() => null);
    await capture(pet, '#stage', 'failure-stage').catch(() => {});
  }
  report = { status: 'FAILED', phase, packaged: !!process.env.MMD_TEST_EXE, appDirectory, profile,
    checked, screenshots, errors, serverErrors, requestCount: requests.length, diagnostics,
    remoteRequests: await remoteAttempts().catch(() => []), runtimeHashes: runtimeBefore,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000), failure: error instanceof Error ? error.stack : String(error) };
  throw error;
} finally {
  try {
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report ?? { status: 'FAILED', phase, checked, errors }, null, 2) + '\n');
  } finally {
    try {
      const shutdown = await closeElectron(instance);
      disarm();
      if (!shutdown.closed) { process.exitCode = 1; console.error('mood-smoke: Electron did not close by itself', shutdown); }
    }
    finally { await claude.close(); }
  }
}
