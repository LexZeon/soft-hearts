import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// PREPARED QA ONLY: run after the native slot is explicitly handed over.
// MMD_TEST_APP_DIR must name a separate frozen source/build, or MMD_TEST_EXE an
// isolated candidate. Every image is original synthetic pixels. There is no real
// desktop capture, camera, microphone, cloud, normal profile or product test IPC.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR ?? workspace);
const executable = process.env.MMD_TEST_EXE ? path.resolve(process.env.MMD_TEST_EXE) : null;
if (!executable && (!process.env.MMD_TEST_APP_DIR
  || (await realpath(appDirectory)).toLowerCase() === (await realpath(workspace)).toLowerCase())) {
  throw new Error('Set MMD_TEST_APP_DIR to a separate frozen candidate, or MMD_TEST_EXE to an isolated packaged candidate.');
}
const output = path.join(workspace, '.local', 'proactive-vision-smoke');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-proactive-vision-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile);
const exec = promisify(execFile);
const startedAt = Date.now();
const checked = [], pageErrors = [], serverErrors = [], requests = [];
const watched = new WeakSet();
const ownedPids = new Set();
const nativeReplyObservations = [];
const cleanup = { appClosed: false, remainingPids: [], fakeClaudeExited: false, errors: [] };
let instance, controls, pet, report, runtimeBefore;
// No HTTP origin is allowed: chat runs through the synthetic Claude Code process.
const origin = null;
// A second Claude model whose image capability has not been seen in this run (phase 08).
const UNVERIFIED_MODEL = 'sonnet';
let phase = 'prepare', guarded = false, replyMode = 'complete';
let sequence = 0;
const ordinaryReply = '原创合成图像的普通附图验证已经完成。';
const proactiveReply = '刚看到共享画面里蓝色和金色的色块，看起来像一幅抽象小画。想和我聊聊它吗？';

const completeCount = () => requests.filter(request => request.proactive && request.completed).length;
// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs); images arrive as stream-json image blocks.
const claude = await createClaudeFixture({ root: temporary, respond: turn => {
  try {
    assert.equal(turn.model, claude.model);
    assert.ok(turn.images.length >= 1 && turn.images.length <= 2);
    for (const image of turn.images) assert.match(image.dataUrl, /^data:image\/(jpeg|png);base64,/);
    const proactive = turn.text.includes('角色主动发起的视觉话题');
    const entry = { number: requests.length + 1, proactive, imageCount: turn.images.length,
      lastText: turn.currentUser ?? '', mode: proactive ? replyMode : 'ordinary',
      completed: false, aborted: false };
    requests.push(entry);
    const finish = () => {
      if (turn.cancelled) return;
      entry.completed = true;
      turn.reply(proactive ? proactiveReply : ordinaryReply);
    };
    const timer = setTimeout(finish, proactive && replyMode !== 'complete' ? 15_000 : 120);
    turn.onCancel(() => { clearTimeout(timer); entry.aborted = !entry.completed; });
  } catch (error) {
    serverErrors.push(error instanceof Error ? error.message : String(error));
    throw error;
  }
} });

function check(name) { checked.push(name); console.log(`PASS ${name}`); }
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(predicate, label, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${phase} / ${label}`);
}
function watch(window) {
  if (watched.has(window)) return;
  watched.add(window);
  window.on('pageerror', error => pageErrors.push(error.message));
  window.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('ERR_ABORTED')) pageErrors.push(message.text());
  });
}
async function runtimeHashes() {
  const files = [];
  if (executable) {
    files.push(executable, path.join(path.dirname(executable), 'resources', 'app.asar'));
  } else {
    files.push(path.join(appDirectory, 'package.json'));
    for (const folder of ['dist', 'dist-electron']) {
      async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (/\.(?:js|cjs|mjs|css|html|wasm)$/i.test(entry.name)) files.push(file);
        }
      }
      await visit(path.join(appDirectory, folder));
    }
    assert.ok(files.some(file => file.endsWith('main.cjs')), 'Frozen host runtime exists');
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [
    path.relative(appDirectory, file), createHash('sha256').update(await readFile(file)).digest('hex'),
  ])));
}
async function diagnostics() {
  if (!instance || !guarded) return null;
  return instance.evaluate(() => ({ captureCalls: globalThis.__visionFixtureCaptureCalls,
    remoteRequests: globalThis.__visionFixtureRemote, permissionRequests: globalThis.__visionFixturePermissions }));
}
async function getMood() { return controls.evaluate(() => window.desktop.getMood()); }
async function initiativeRecords() {
  return controls.evaluate(() => window.desktop.listMemories({ tag: '角色主动' }));
}
async function delivered(window = pet) {
  return window.evaluate(() => window.__visionFixture.delivered);
}
async function screenCount() { return (await diagnostics()).captureCalls.length; }

async function assertNativeReply(message) {
  let bubble;
  await waitFor(() => {
    bubble = instance.windows().find(window => window.url().endsWith('#soft-hearts-reply'));
    return !!bubble;
  }, 'separate native reply surface exists');
  const expected = `主动 · ${message.origin.labels.join('、')}\n${message.text}`;
  let native, rendered;
  await waitFor(async () => {
    native = await instance.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().endsWith('#soft-hearts-reply'));
      return window && { visible: window.isVisible(), minimized: window.isMinimized(), opacity: window.getOpacity(), bounds: window.getBounds() };
    });
    if (!native?.visible || native.minimized || !(native.opacity > 0)) return false;
    rendered = await bubble.evaluate(() => {
      const node = document.querySelector('#reply-body');
      if (!node) return null;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node), body = getComputedStyle(document.body);
      return { text: node.textContent, width: rect.width, height: rect.height,
        waiting: node.classList.contains('reply-waiting'), display: style.display, visibility: style.visibility,
        opacity: Number(style.opacity) * Number(body.opacity) };
    });
    return rendered?.text === expected && !rendered.waiting && rendered.width > 0 && rendered.height > 0
      && rendered.display !== 'none' && rendered.visibility !== 'hidden' && rendered.opacity > 0;
  }, 'exact proactive body is visible in the native reply window', 4_000);
  nativeReplyObservations.push({ id: message.id, sources: message.origin.sources, native, rendered });
}

async function launch() {
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'MMD_TEST_CODEX', 'MMD_TEST_LOCAL_URL', 'MMD_TEST_LOCAL_MODEL', 'VITE_DEV_SERVER_URL']) delete env[key];
  const args = executable ? [] : [appDirectory];
  args.push(`--user-data-dir=${profile}`, '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost');
  instance = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args, cwd: appDirectory, env, timeout: 30_000 });
  await claude.install(instance);
  ownedPids.add(instance.process().pid);
  instance.on('window', watch);
  await instance.firstWindow();
  assert.equal(path.resolve(await instance.evaluate(({ app }) => app.getPath('userData'))), profile);
  await instance.evaluate(async ({ session, desktopCapturer, nativeImage, screen }, allowedOrigin) => {
    globalThis.__visionFixtureRemote = [];
    globalThis.__visionFixturePermissions = [];
    globalThis.__visionFixtureCaptureCalls = [];
    // Create all pixels in memory. The original desktopCapturer implementation
    // is never called, including on a failed assertion or source lookup.
    const width = 640, height = 360, bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      bitmap[at] = x < width / 2 ? 210 : 45;
      bitmap[at + 1] = x < width / 2 ? 95 : 185;
      bitmap[at + 2] = x < width / 2 ? 35 : 235;
      bitmap[at + 3] = 255;
    }
    const image = nativeImage.createFromBitmap(bitmap, { width, height });
    if (image.isEmpty()) throw new Error('Original synthetic NativeImage is empty');
    desktopCapturer.getSources = async options => {
      if (JSON.stringify(options.types) !== '["screen"]') throw new Error('Fixture forbids window/desktop video source capture');
      globalThis.__visionFixtureCaptureCalls.push({ at: Date.now(), types: [...options.types] });
      return screen.getAllDisplays().map(display => ({ id: `screen:${display.id}:0`, display_id: String(display.id),
        name: 'Original blue/gold synthetic fixture', thumbnail: image, appIcon: null }));
    };
    await fetch('data:text/plain,vision-fixture-network-guard');
    const key = Symbol.for('undici.globalDispatcher.1'), dispatcher = globalThis[key];
    if (!dispatcher?.dispatch) throw new Error('Cannot install host fetch guard');
    globalThis[key] = { dispatch(options, handler) {
      if (String(options.origin) !== allowedOrigin) {
        globalThis.__visionFixtureRemote.push(`${options.origin}${options.path}`);
        handler.onError(new Error('VISION_FIXTURE_REMOTE_BLOCKED')); return false;
      }
      return dispatcher.dispatch(options, handler);
    } };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const remote = /^https?:/i.test(details.url) && new URL(details.url).origin !== allowedOrigin;
      if (remote) globalThis.__visionFixtureRemote.push(details.url);
      callback({ cancel: remote });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      globalThis.__visionFixturePermissions.push(permission); callback(false);
    });
  }, origin);
  guarded = true;
  await waitFor(() => {
    for (const window of instance.windows()) watch(window);
    controls = instance.windows().find(window => {
      try { const url = new URL(window.url()); return url.pathname.endsWith('/index.html') && !url.searchParams.has('pet'); } catch { return false; }
    });
    pet = instance.windows().find(window => {
      try { const url = new URL(window.url()); return url.pathname.endsWith('/index.html') && url.searchParams.has('pet'); } catch { return false; }
    });
    return !!controls && !!pet;
  }, 'both app windows');
  for (const window of [controls, pet]) {
    window.setDefaultTimeout(12_000);
    await window.waitForFunction(() => typeof window.desktop?.getVisionRuntime === 'function');
    await window.evaluate(() => {
      window.__visionFixture = { streams: [], offers: [], delivered: [], cameraRequests: [], cameraAcquisitions: 0, cameraStops: 0 };
      window.desktop.onStream(event => window.__visionFixture.streams.push(event));
      window.desktop.onVisionInitiative(event => window.__visionFixture.offers.push(event));
      window.desktop.onVisionInitiativeDelivered(message => window.__visionFixture.delivered.push(message));
      window.desktop.onCameraSample(id => window.__visionFixture.cameraRequests.push(id));
      // Camera frames come from this app-local synthetic canvas. Never invoke
      // native getUserMedia, enumerateDevices or a real media permission prompt.
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (constraints.audio !== false || !constraints.video) throw new Error('Fixture forbids real/audio media');
        window.__visionFixture.cameraAcquisitions++;
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d');
        context.fillStyle = '#235fd2'; context.fillRect(0, 0, 320, 360);
        context.fillStyle = '#ebba2d'; context.fillRect(320, 0, 320, 360);
        const stream = canvas.captureStream(5);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { window.__visionFixture.cameraStops++; stop(); };
        }
        return stream;
      };
    });
  }
  await controls.evaluate(async () => {
    await window.desktop.setMoodExpressions(false);
    await window.desktop.setVisionOptions({ proactiveVision: false });
    await window.desktop.useBundledModel();
  });
  await waitFor(async () => pet.evaluate(() => document.querySelector('#pet-status')?.textContent?.includes('VMD 播放中')), 'offline Gene', 60_000);
}

async function prepareRole(name) {
  await controls.evaluate(async name => {
    await window.desktop.setMoodExpressions(false);
    const before = await window.desktop.getCharacterCards();
    const state = await window.desktop.saveCharacterCard({ name: `合成视觉QA-${name}`, description: '隔离自动化测试角色，不是Gene或用户角色。',
      personality: '温和简短', scenario: '', greeting: '', examples: '', systemPrompt: '' });
    const role = state.cards.find(card => !before.cards.some(old => old.id === card.id));
    if (!role) throw new Error('New isolated fixture character missing');
    await window.desktop.activateCharacterCard(role.id);
    await window.desktop.setMoodDeveloperMode(true);
    const view = await window.desktop.getMood(), parameters = structuredClone(view.parameters);
    // Existing public developer API only, on a new temporary QA character. A
    // restored high-B fixture would be reset offline; these valid test thresholds
    // allow the ordinary 1s mood tick without changing time or production rules.
    parameters.boredom.lookAt = parameters.boredom.motionAt = parameters.boredom.speechAt = 0;
    await window.desktop.setMoodParameters(parameters, { characterId: view.characterId, token: view.token });
    await window.desktop.setMoodDeveloperMode(false);
    await window.desktop.setVisionOptions({ proactiveVision: true, autoCapture: false });
  }, name);
  for (const window of [controls, pet]) await window.locator('#chat-input').fill('');
  await pet.evaluate(() => document.activeElement?.blur());
  // The host keeps a 15s quiet period after user input. Wait in real time; do not
  // change a clock, shorten the product guard or rewrite an accepted quota.
  await pet.waitForTimeout(16_200);
  assert.equal((await getMood()).snapshot.lastInteractionAt, null);
  assert.equal((await initiativeRecords()).total, 0);
}
async function armAndWait(previousCount) {
  await controls.evaluate(() => window.desktop.setMoodExpressions(true));
  await waitFor(() => requests.filter(request => request.proactive).length > previousCount, 'one accepted proactive request');
}
async function waitDelivered(previousCount) {
  await waitFor(async () => (await delivered()).length > previousCount, 'pet append acknowledged and archived');
  const result = (await delivered()).at(-1);
  await waitFor(async () => (await delivered(controls)).some(message => message.id === result.id), 'controls delivery mirror');
  return result;
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

try {
  runtimeBefore = await runtimeHashes();
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, model: null, motion: null,
    provider: claude.provider,
    voiceInput: { baseUrl: 'http://127.0.0.1:9/v1', model: 'never-used-asr', apiKey: '', language: 'zh' },
    persona: 'Original synthetic vision QA.', pet: { visible: true, clickThrough: false, scale: 1, followMouse: false, fps: 24 },
    voice: { enabled: false, rate: 1, volume: 0 } }));
  await launch();

  phase = '01-default-off-and-no-idle-capture';
  assert.deepEqual(await controls.evaluate(() => window.desktop.getRuntimeState()), {
    voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null,
  });
  assert.equal((await controls.evaluate(() => window.desktop.getVisionRuntime())).autoCapture, false);
  await pet.waitForTimeout(2_200);
  assert.equal(await screenCount(), 0); assert.equal(requests.length, 0);
  check('media defaults off, auto screenshot off (retired), no idle capture or model request');

  // 识图第 1 步 retired R09 自动截图: no switch or interval any more, an old request for it is ignored, nothing is sampled.
  phase = '02-screen-options-without-automatic-snapshots';
  await navigateControlPage(controls, 'privacy');
  const options = controls.locator('.control-sharing-options .screen-sharing-options');
  assert.equal(await options.isVisible(), false);
  await controls.locator('#runtime-screen').check();
  await options.waitFor({ state: 'visible' });
  assert.equal(await options.locator('[data-screen-option="autoCapture"]').count(), 0);
  assert.equal(await options.locator('[data-screen-option="intervalSeconds"]').count(), 0);
  await options.locator('[data-screen-option="lookHint"]').waitFor({ state: 'visible' });
  assert.equal((await controls.evaluate(() => window.desktop.setVisionOptions({ autoCapture: true, intervalSeconds: 2 }))).autoCapture, false);
  await pet.waitForTimeout(2_300);
  assert.equal(await screenCount(), 0, 'nothing is sampled in the background');
  assert.equal(requests.length, 0);
  await options.screenshot({ path: path.join(output, 'screen-options-controls.png') });
  await pet.mouse.move(25, 22);
  await pet.locator('#pet-toolbar').evaluate(element => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + 15, clientY: rect.top + 12 }));
  });
  await pet.locator('#pet-toolbar.is-visible').waitFor();
  await pet.locator('#pet-toolbar').screenshot({ path: path.join(output, 'screen-options-pet.png') });
  assert.deepEqual(await controls.evaluate(() => window.desktop.sharedAttachments({ text: 'ORDINARY' })), [], 'an ordinary message carries no frame');
  await controls.locator('#runtime-screen').uncheck();
  await options.waitFor({ state: 'hidden' });
  assert.deepEqual(await controls.evaluate(() => window.desktop.sharedAttachments({ look: true })), []);
  check('enabled screen shows the look hint without snapshot controls, samples nothing, off collapses');

  phase = '03-api-image-capability-proof';
  await controls.evaluate(() => window.desktop.setRuntimeState({ screenSharing: true }));
  const ordinaryId = `vision-baseline-${++sequence}`;
  await controls.evaluate(async id => {
    const attachments = await window.desktop.sharedAttachments({ text: '你看看我屏幕', look: true });
    if (attachments.length !== 1 || attachments[0].source !== 'screen') throw new Error('Single authorized synthetic screen expected');
    await window.desktop.chat({ id, messages: [{ role: 'user', content: 'ORDINARY_IMAGE_BASELINE' }], attachments });
  }, ordinaryId);
  await waitFor(async () => controls.evaluate(id => window.__visionFixture.streams.some(event => event.id === id && event.type === 'done'), ordinaryId), 'ordinary attached-image completion');
  assert.equal(requests.length, 1); assert.equal(requests[0].proactive, false);
  check('ordinary successful synthetic attachment establishes host API image support');

  phase = '04-one-screen-initiative-and-assistant-only-memory';
  await prepareRole('screen-delivery');
  const deliveredBefore = (await delivered()).length, requestsBefore = requests.filter(request => request.proactive).length;
  const moodBefore = (await getMood()).snapshot;
  await armAndWait(requestsBefore);
  const first = await waitDelivered(deliveredBefore);
  await assertNativeReply(first);
  assert.deepEqual(first.origin.sources, ['screen']);
  assert.deepEqual(first.origin.labels, ['屏幕']);
  assert.equal(first.text, proactiveReply);
  // This pet body is only a DOM proxy. The actual visible native reply was
  // independently checked above; the controls own the full chat log.
  assert.match(await pet.locator('#pet-answer-body').textContent(), /主动 · 屏幕/);
  assert.match(await pet.locator('#pet-answer-body').textContent(), /蓝色和金色的色块/);
  assert.match(await controls.locator('#messages').textContent(), /主动 · 屏幕/);
  const records = await initiativeRecords(); assert.equal(records.total, 1);
  const record = await controls.evaluate(id => window.desktop.readMemory(id), records.records[0].id);
  assert.equal(record.messages.length, 1); assert.equal(record.messages[0].role, 'assistant');
  assert.equal(record.messages[0].content, proactiveReply); assert.equal(record.origin.id, first.id);
  assert.equal(record.weight, 0); assert.deepEqual(record.origin.sources, ['screen']);
  await navigateControlPage(controls, 'memory');
  const memoryButton = controls.locator(`#memory-list [data-record-id="${record.id}"]`);
  await memoryButton.waitFor({ state: 'visible' });
  assert.match(await memoryButton.textContent(), /伙伴主动 · 屏幕/);
  await memoryButton.click();
  await controls.locator('#memory-detail').getByText('伙伴主动发起', { exact: false }).waitFor();
  assert.match(await controls.locator('#memory-detail').textContent(), /不代表你作出的陈述或承诺/);
  const after = (await getMood()).snapshot;
  assert.equal(after.lastInteractionAt, moodBefore.lastInteractionAt);
  for (const channel of ['D', 'O', 'E', 'N', 'C']) assert.ok(Math.abs(after.values[channel] - moodBefore.values[channel]) < 1e-6);
  await pet.waitForTimeout(3_500);
  assert.equal(requests.filter(request => request.proactive).length, requestsBefore + 1);
  assert.equal((await delivered()).filter(message => message.id === first.id).length, 1);
  assert.equal((await delivered(controls)).filter(message => message.id === first.id).length, 1);
  check('one mood speech opportunity presents an actual native reply, delivers once across two windows, assistant-only memory and no reward');

  phase = '05-sharing-off-cancels-in-flight-generation';
  replyMode = 'hold-source-off';
  await prepareRole('source-cancel');
  const offDelivered = (await delivered()).length, offRequests = requests.filter(request => request.proactive).length;
  await armAndWait(offRequests);
  const sourceRequest = requests.at(-1);
  await controls.evaluate(() => window.desktop.setRuntimeState({ screenSharing: false }));
  await waitFor(() => sourceRequest.aborted, 'HTTP aborted when sharing closes');
  await pet.waitForTimeout(1_000);
  assert.equal((await delivered()).length, offDelivered);
  assert.equal((await initiativeRecords()).total, 0);
  const offCaptures = await screenCount();
  await pet.waitForTimeout(2_100); assert.equal(await screenCount(), offCaptures);
  check('sharing off cancels an actual local SSE generation and clears visual context without late delivery');

  phase = '06-user-input-cancels-in-flight-generation';
  replyMode = 'hold-user-input';
  await prepareRole('input-cancel');
  await controls.evaluate(() => window.desktop.setRuntimeState({ screenSharing: true }));
  const inputDelivered = (await delivered()).length, inputRequests = requests.filter(request => request.proactive).length;
  await armAndWait(inputRequests);
  const inputRequest = requests.at(-1);
  await pet.locator('#chat-input').fill('合成用户草稿，打断角色主动话题');
  await waitFor(() => inputRequest.aborted, 'HTTP aborted by real renderer input event');
  await pet.waitForTimeout(1_000);
  assert.equal(await pet.locator('#chat-input').inputValue(), '合成用户草稿，打断角色主动话题');
  assert.equal((await delivered()).length, inputDelivered);
  assert.equal((await initiativeRecords()).total, 0);
  await pet.waitForTimeout(3_500);
  assert.equal(requests.filter(request => request.proactive).length, inputRequests + 1);
  check('user input interrupts active vision generation, preserves the draft, never retries or archives a cancelled line');

  phase = '07-camera-event-only-synthetic-source';
  replyMode = 'complete';
  await prepareRole('camera-delivery');
  await controls.evaluate(() => window.desktop.setRuntimeState({ screenSharing: false }));
  await pet.evaluate(() => window.desktop.setRuntimeState({ cameraSharing: true }));
  await waitFor(async () => pet.evaluate(() => window.__visionFixture.cameraAcquisitions === 1), 'synthetic canvas camera stream');
  await pet.waitForTimeout(2_200);
  assert.deepEqual(await pet.evaluate(() => window.__visionFixture.cameraRequests), []);
  const cameraScreenBefore = await screenCount(), cameraDelivered = (await delivered()).length;
  const cameraRequests = requests.filter(request => request.proactive).length;
  await armAndWait(cameraRequests);
  const cameraLine = await waitDelivered(cameraDelivered);
  await assertNativeReply(cameraLine);
  assert.deepEqual(cameraLine.origin.sources, ['camera']);
  assert.equal(requests.at(-1).imageCount, 1);
  assert.equal(await screenCount(), cameraScreenBefore, 'camera-only event never asks for a screen');
  assert.equal((await pet.evaluate(() => window.__visionFixture.cameraRequests)).length, 1);
  await pet.evaluate(() => window.desktop.setRuntimeState({ cameraSharing: false }));
  await waitFor(async () => pet.evaluate(() => window.__visionFixture.cameraStops === 1), 'owned synthetic camera track released');
  check('camera uses one accepted host event, only a synthetic canvas frame, no camera timer, source isolation and track release');

  phase = '08-unverified-provider-skips-without-capture';
  await controls.evaluate(async model => {
    await window.desktop.setMoodExpressions(false);
    const settings = await window.desktop.getSettings(); settings.provider.model = model;
    await window.desktop.saveSettings(settings);
  }, UNVERIFIED_MODEL);
  await prepareRole('unverified-provider');
  await controls.evaluate(() => window.desktop.setRuntimeState({ screenSharing: true }));
  const unverifiedCaptures = await screenCount(), unverifiedRequests = requests.length;
  await controls.evaluate(() => window.desktop.setMoodExpressions(true));
  await waitFor(async () => controls.evaluate(async () => {
    const state = await window.desktop.getVisionRuntime();
    return !state.supported && !!state.status;
  }), 'unverified capability skip status');
  assert.equal(await screenCount(), unverifiedCaptures);
  assert.equal(requests.length, unverifiedRequests);
  check('unverified image capability skips the event before capture or model request');

  phase = '09-boundaries-and-runtime-identity';
  await controls.evaluate(() => window.desktop.setRuntimeState({ screenSharing: false, cameraSharing: false, voiceInput: false }));
  const diagnostic = await diagnostics();
  assert.deepEqual(diagnostic.remoteRequests, []);
  assert.deepEqual(diagnostic.permissionRequests, []);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(pageErrors, []);
  claude.assertClean([claude.model, UNVERIFIED_MODEL]); assert.deepEqual((await claude.evidence(instance)).denied, []);
  assert.deepEqual(await runtimeHashes(), runtimeBefore);
  const journal = await readFile(path.join(profile, 'memories.jsonl'), 'utf8');
  assert.ok(!journal.includes('data:image/'), 'raw synthetic pictures never enter the text archive');
  check('no remote request or real media permission, no raw-frame archive, exact runtime unchanged');
  report = { status: 'PASS', phase, packaged: !!executable, checked, requestCount: requests.length,
    proactiveCompleteCount: completeCount(), requests, syntheticCaptures: diagnostic.captureCalls.length,
    nativeReplyObservations,
    remoteRequests: diagnostic.remoteRequests, permissionRequests: diagnostic.permissionRequests,
    pageErrors, serverErrors, runtimeHashes: runtimeBefore,
    limits: [
      'This script uses only original synthetic screen pixels and app-local canvas video; no real desktop, microphone or camera is accepted.',
      'The ordinary mood tick and developer API run on temporary QA characters with zero boredom thresholds, not normal Gene parameters.',
      'Cross-source ambient/vision contention and deeper expiry/scope cases remain pure gate/runtime tests; this script does not synthesize an ambient session.',
      'Only the synthetic Claude Code (fake CLI) is exercised. Real Claude image understanding, subjective dialogue quality and daily deployment require separate acceptance.',
      'Native reply visibility/body is checked separately from the hidden pet DOM proxy. Publish-before-ack and late-ack fencing are also covered by pure delivery/engine tests.',
      'The initial preparation was syntax-checked only; a PASS report is produced only by an actual later native run.',
    ] };
} catch (error) {
  report = { status: 'FAILED', phase, checked, requests, nativeReplyObservations, pageErrors, serverErrors, runtimeHashes: runtimeBefore,
    diagnostics: await diagnostics().catch(() => null),
    failure: error instanceof Error ? error.stack : String(error) };
  process.exitCode = 1;
} finally {
  if (instance) {
    try {
      const pids = await instance.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid));
      for (const pid of pids) ownedPids.add(pid);
    } catch { /* The owned process may already have exited on a failed launch. */ }
    try { await bounded(instance.close(), 8_000, 'owned Electron close'); }
    catch (error) { cleanup.errors.push(String(error)); }
    if ([...ownedPids].some(processAlive)) {
      // Only PIDs returned by this launch handle/app metrics are eligible. Never
      // stop a normal app by image name or enumerate arbitrary Electron tasks.
      for (const pid of [...ownedPids].filter(processAlive)) {
        try {
          if (process.platform === 'win32') await exec(path.join(process.env.WINDIR ?? 'C:/Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8_000 });
          else process.kill(pid, 'SIGKILL');
        } catch (error) { if (processAlive(pid)) cleanup.errors.push(`Owned PID ${pid}: ${error.message}`); }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    cleanup.remainingPids = [...ownedPids].filter(processAlive);
    cleanup.appClosed = cleanup.remainingPids.length === 0;
  } else cleanup.appClosed = true;
  const fake = await claude.close();
  cleanup.fakeClaudeExited = fake.fakeClaudeExited && fake.claudeHomeEmpty;
  if (!cleanup.appClosed || !cleanup.fakeClaudeExited || cleanup.errors.length) {
    process.exitCode = 1;
    report = { ...report, status: 'FAILED', cleanupFailure: true };
  }
  report = { ...report, temporaryProfile: profile, elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000), cleanup };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checked: checked.length, requestCount: requests.length, cleanup }, null, 2));
}
