import { _electron as electron } from 'playwright';
import { navigateControlPage } from './lib/control-navigation.mjs';
import { createClaudeFixture } from './lib/claude-smoke-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Acquire the native test lease in ACTIVE-WORK.md before running. This script
// never builds, uses a normal profile, captures a desktop, or plays real audio.
// MMD_TEST_APP_DIR selects an existing source build; MMD_TEST_EXE selects an
// already packaged app. All speech events below are synthetic and silent.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDirectory = path.resolve(process.env.MMD_TEST_APP_DIR || workspace);
const executable = process.env.MMD_TEST_EXE ? path.resolve(process.env.MMD_TEST_EXE) : undefined;
const output = path.join(workspace, '.local', 'reply-speech-smoke');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], requests = [], timings = {};
let inactiveCardRevision;
const replies = Object.fromEntries([
  'CONTROLS', 'PET', 'OLD', 'NEW', 'ERROR', 'PLAYBACK_STOP', 'CANCEL', 'NO_VOICE', 'STOP', 'HIDE',
].map(name => [`SPEECH_${name}`, `MOCK_${name}_REPLY`]));
let instance, controls, pet, temporary, profile, report, appClosed = true;
let claude;

const check = name => { checks.push(name); console.log(`PASS ${name}`); };
async function waitFor(condition, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let nextProgress = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (Date.now() >= nextProgress) { console.log(`WAIT ${label}`); nextProgress += 12000; }
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

// Chat goes to a synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs) that streams these fixed replies.
const respond = turn => {
  const timers = [];
  let record;
  turn.onCancel(() => { timers.forEach(clearTimeout); if (record) record.aborted = !record.completed; });
  const prompt = turn.currentUser;
  assert.equal(typeof prompt, 'string'); assert.ok(Object.hasOwn(replies, prompt));
  record = { prompt, completed: false, aborted: false }; requests.push(record);
  turn.delta(replies[prompt]);
  timers.push(setTimeout(() => {
    record.completed = true; record.completedAt = Date.now(); turn.done();
  }, prompt === 'SPEECH_STOP' ? 20000 : 300));
};

async function nativeState() {
  return instance.evaluate(({ app, BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const owner = all.find(win => /index\.html(?:\?|$)/.test(win.webContents.getURL()) && new URL(win.webContents.getURL()).searchParams.has('pet'));
    const reply = all.find(win => win.webContents.getURL().endsWith('#soft-hearts-reply'));
    return {
      packaged: app.isPackaged, profile: app.getPath('userData'),
      petVisible: Boolean(owner?.isVisible() && !owner.isMinimized()),
      replyVisible: Boolean(reply?.isVisible()),
      reply: reply && { bounds: reply.getBounds(), focusable: reply.isFocusable(), parent: reply.getParentWindow()?.id },
      blockedRequests: [...(globalThis.__replySpeechBlockedRequests || [])],
    };
  });
}
async function visible() { return (await nativeState()).replyVisible; }
async function waitText(expected) {
  await waitFor(async () => {
    const bubble = instance.windows().find(page => page.url().endsWith('#soft-hearts-reply'));
    return bubble && await visible() && await bubble.evaluate(text => document.getElementById('reply-body')?.textContent === text, expected);
  }, `native reply ${expected}`);
}
async function staysVisible(milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const state = await nativeState();
    assert.equal(state.petVisible, true, `${label}: pet is visible`);
    assert.equal(state.replyVisible, true, `${label}: actual auxiliary window is visible`);
    await pause(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}
async function staysHidden(milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    assert.equal(await visible(), false, label);
    await pause(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}
async function expires(after, label) {
  await staysVisible(Math.max(0, 4200 - (Date.now() - after)), `${label} before five seconds`);
  await waitFor(async () => !await visible(), `${label} five-second expiry`, 2800);
  const elapsed = Date.now() - after;
  assert.ok(elapsed >= 4850 && elapsed <= 7000, `${label} expiry observed at ${elapsed} ms`);
  timings[label] = elapsed;
}
async function submit(page, prompt) {
  await page.evaluate(value => {
    const input = document.getElementById('chat-input'); input.value = value;
    document.getElementById('chat-form').requestSubmit();
  }, prompt);
}
async function chatDone() {
  await waitFor(() => controls.evaluate(() => !document.getElementById('send-chat').classList.contains('hidden')), 'chat completed');
}

async function installSpeechMock(page) {
  await page.evaluate(() => {
    const records = [];
    let active = null, cancellations = 0, cloudEvents = 0;
    const summary = record => ({ index: record.index, text: record.utterance.text, started: record.started, ended: record.ended, errored: record.errored, cancelled: record.cancelled });
    Object.defineProperties(speechSynthesis, {
      speak: { configurable: true, value: utterance => {
        const record = { index: records.length, utterance, started: false, ended: false, errored: false, cancelled: false };
        records.push(record); active = record;
      } },
      cancel: { configurable: true, value: () => {
        cancellations++;
        if (active) active.cancelled = true;
        active = null;
        // Browser cancellation callbacks can arrive late; fire() controls them.
      } },
      getVoices: { configurable: true, value: () => [] },
    });
    window.desktop.onSpeechEvent(() => { cloudEvents++; });
    window.__softReplySpeechMock = {
      snapshot: () => ({ installed: true, records: records.map(summary), cancellations, cloudEvents }),
      fire(index, type) {
        const record = records[index];
        if (!record || !['start', 'end', 'error'].includes(type)) throw new Error('Unknown synthetic speech event');
        if (type === 'start') { record.started = true; if (!record.cancelled) active = record; }
        if (type === 'end') record.ended = true;
        if (type === 'error') record.errored = true;
        if (type !== 'start' && active === record) active = null;
        const at = Date.now(); record.utterance[`on${type}`]?.call(record.utterance, new Event(type));
        return at;
      },
    };
  });
  assert.equal((await speechState(page)).installed, true);
}
async function speechState(page) { return page.evaluate(() => window.__softReplySpeechMock.snapshot()); }
async function fire(page, index, type) { return page.evaluate(value => window.__softReplySpeechMock.fire(value.index, value.type), { index, type }); }
async function speechRecord(page, text) {
  let record;
  await waitFor(async () => { record = (await speechState(page)).records.find(item => item.text === text); return record; }, `mock utterance ${text}`);
  return record;
}
async function voicedReply(page, prompt) {
  await submit(page, prompt); await waitText(replies[prompt]); await chatDone();
  return speechRecord(page, replies[prompt]);
}
async function voiceEnabled(enabled) {
  await controls.evaluate(value => {
    const input = document.getElementById('voice-enabled'); input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, enabled);
  await waitFor(async () => (await controls.evaluate(() => window.desktop.getSettings())).voice.enabled === enabled, `voice preference ${enabled}`);
  await pause(150);
}
async function closeOwnedApp() {
  if (!instance) return;
  const child = instance.process();
  let timer;
  try {
    await Promise.race([instance.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned Electron close timed out')), 10000); })]);
  } catch (error) {
    if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.exitCode === null) {
      // The PID comes only from the Electron instance this script launched.
      if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }
    errors.push(`owned app cleanup: ${error.message}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const exited = () => { clearTimeout(exitTimer); resolve(); };
      const exitTimer = setTimeout(() => { child.removeListener('exit', exited); resolve(); }, 2500);
      child.once('exit', exited);
    });
    appClosed = child.exitCode !== null || child.signalCode !== null;
  }
}

try {
  await mkdir(output, { recursive: true });
  temporary = await mkdtemp(path.join(os.tmpdir(), 'soft-reply-speech-e2e-'));
  profile = path.join(temporary, 'profile'); await mkdir(profile);
  claude = await createClaudeFixture({ root: temporary, respond });
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
    version: 1, model: null, motion: null,
    provider: claude.provider,
    persona: 'Synthetic local speech lifecycle test companion.',
    pet: { visible: true, alwaysOnTop: true, clickThrough: false, scale: 1, followMouse: false, fps: 24 },
    voice: { enabled: true, voiceURI: '', rate: 1, volume: 0 },
    tts: { provider: 'system', apiHost: '', region: '', model: 'qwen-audio-3.1-tts-flash', voice: 'longanlingxin_v3.1', instruction: '', emotion: 'custom', rate: 1, apiKey: '', introduced: true, styleBindings: [] },
  }));
  const env = claude.environment({ ...process.env, MMD_DESK_USER_DATA: profile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  console.log('START isolated reply speech smoke: mock audio only; no real speech engine, devices, keys or external model');
  instance = await electron.launch({
    ...(executable ? { executablePath: executable, args: [`--user-data-dir=${profile}`] } : { args: [appDirectory, `--user-data-dir=${profile}`] }),
    cwd: appDirectory, env, timeout: 30000,
  });
  appClosed = false;
  await claude.install(instance);
  await instance.firstWindow();
  await waitFor(() => {
    controls = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && !new URL(page.url()).searchParams.has('pet'));
    pet = instance.windows().find(page => /index\.html(?:\?|$)/.test(page.url()) && new URL(page.url()).searchParams.has('pet'));
    return controls && pet;
  }, 'control and pet windows');
  for (const [name, page] of [['controls', controls], ['pet', pet]]) {
    page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.waitForSelector('#chat-input'); await installSpeechMock(page);
  }
  // Chat runs through the fake Claude Code process; no renderer HTTP is allowed at all.
  await instance.evaluate(({ session }) => {
    globalThis.__replySpeechBlockedRequests = [];
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
      globalThis.__replySpeechBlockedRequests.push(new URL(request.url).origin);
      callback({ cancel: true });
    });
  });
  const start = await nativeState();
  assert.equal(start.profile, profile); assert.equal(start.packaged, Boolean(executable));
  await controls.evaluate(() => window.desktop.useBundledModel());
  await waitFor(() => pet.evaluate(() => /模型已就绪|VMD 播放中/.test(document.getElementById('pet-status')?.textContent || '')), 'bundled Gene ready', 45000);
  await navigateControlPage(controls, 'appearance');
  await controls.evaluate(() => document.getElementById('frame-portrait').click());
  await pause(500);
  check('isolated profile, public Gene and silent controlled speech mocks in both windows');

  const controlSpeech = await voicedReply(controls, 'SPEECH_CONTROLS');
  assert.equal(controlSpeech.started, false);
  const preparationAt = Date.now();
  inactiveCardRevision = await controls.evaluate(async () => {
    const before = await window.desktop.getCharacterCards();
    const after = await window.desktop.saveCharacterCard({
      name: 'Original inactive speech lifecycle fixture',
      description: 'An original test card that remains inactive during queued speech.',
      personality: '', scenario: '', greeting: '', examples: '', systemPrompt: '',
    });
    return { activeBefore: before.activeId, activeAfter: after.activeId, revisionBefore: before.revision, revisionAfter: after.revision };
  });
  assert.equal(inactiveCardRevision.activeAfter, inactiveCardRevision.activeBefore);
  assert.ok(inactiveCardRevision.revisionAfter > inactiveCardRevision.revisionBefore);
  await staysVisible(Math.max(0, 6200 - (Date.now() - preparationAt)), 'controls queued preparation');
  check('controls queued speech stays visible beyond six seconds while an inactive card save changes only the global revision');
  await fire(controls, controlSpeech.index, 'start'); await staysVisible(7200, 'controls playback');
  check('controls-owned playback keeps the actual bubble visible for more than seven seconds');
  await expires(await fire(controls, controlSpeech.index, 'end'), 'controlsSpeechEnd');
  check('controls speech ends with a five-second native expiry despite the unrelated card revision change');

  const petSpeech = await voicedReply(pet, 'SPEECH_PET');
  await staysVisible(1000, 'pet queued preparation'); await fire(pet, petSpeech.index, 'start');
  await staysVisible(5500, 'pet playback');
  await expires(await fire(pet, petSpeech.index, 'end'), 'petSpeechEnd');
  check('pet-owned reply also remains visible across preparation and playback, then expires five seconds after end');

  const oldSpeech = await voicedReply(controls, 'SPEECH_OLD'); await fire(controls, oldSpeech.index, 'start');
  const newSpeech = await voicedReply(pet, 'SPEECH_NEW'); await fire(pet, newSpeech.index, 'start');
  await fire(controls, oldSpeech.index, 'end'); await fire(controls, oldSpeech.index, 'error');
  await staysVisible(6200, 'new reply after stale callbacks'); await waitText(replies.SPEECH_NEW);
  await fire(pet, newSpeech.index, 'end');
  check('old utterance end/error callbacks cannot expire the newly held reply');

  const failedSpeech = await voicedReply(controls, 'SPEECH_ERROR');
  await expires(await fire(controls, failedSpeech.index, 'error'), 'speechError');
  check('an error before onstart releases pending speech and receives a five-second expiry');

  const stoppedSpeech = await voicedReply(controls, 'SPEECH_PLAYBACK_STOP');
  await fire(controls, stoppedSpeech.index, 'start');
  await navigateControlPage(controls, 'providers');
  const stoppedAt = await controls.evaluate(() => {
    const stop = document.getElementById('tts-stop');
    if (!stop || stop.disabled) throw new Error('Playback stop control is unavailable');
    const at = Date.now();
    stop.click();
    return at;
  });
  await expires(stoppedAt, 'playbackStop');
  check('the ordinary playback Stop button releases the speech hold and starts five-second expiry');

  const cancelledSpeech = await voicedReply(pet, 'SPEECH_CANCEL'); await fire(pet, cancelledSpeech.index, 'start');
  const beforeCancel = (await speechState(pet)).cancellations, cancelAt = Date.now();
  await voiceEnabled(false);
  await waitFor(async () => (await speechState(pet)).cancellations > beforeCancel, 'owned speech cancelled by voice toggle');
  await expires(cancelAt, 'speechCancel');
  await fire(pet, cancelledSpeech.index, 'end'); await fire(pet, cancelledSpeech.index, 'error');
  await staysHidden(700, 'late cancelled callbacks cannot revive an expired reply');
  check('turning voice off cancels owned playback, releases the hold, and ignores late callbacks');

  const counts = [(await speechState(controls)).records.length, (await speechState(pet)).records.length];
  await submit(controls, 'SPEECH_NO_VOICE'); await waitText(replies.SPEECH_NO_VOICE); await chatDone();
  await expires(requests.find(request => request.prompt === 'SPEECH_NO_VOICE').completedAt, 'noVoice');
  assert.deepEqual([(await speechState(controls)).records.length, (await speechState(pet)).records.length], counts);
  check('disabled voice uses normal five-second expiry without creating an utterance');

  await submit(controls, 'SPEECH_STOP'); await waitText(replies.SPEECH_STOP);
  const generationStoppedAt = Date.now();
  await pet.evaluate(() => document.getElementById('stop-chat').click());
  await chatDone();
  await waitFor(() => requests.find(request => request.prompt === 'SPEECH_STOP')?.aborted, 'stopped synthetic generation aborted');
  await waitFor(async () => {
    const bubble = instance.windows().find(page => page.url().endsWith('#soft-hearts-reply'));
    return await visible() && await bubble.evaluate(() => document.getElementById('reply-body').textContent.includes('[已停止]'));
  }, 'stopped text visible');
  await expires(generationStoppedAt, 'generationStop');
  check('stopping a controls-owned generation from the pet releases streaming state and expires normally');

  await voiceEnabled(true);
  const hiddenSpeech = await voicedReply(pet, 'SPEECH_HIDE'); await fire(pet, hiddenSpeech.index, 'start');
  await controls.evaluate(() => document.getElementById('new-chat').click());
  await waitFor(async () => !await visible(), 'new conversation hides the old reply');
  await fire(pet, hiddenSpeech.index, 'end'); await fire(pet, hiddenSpeech.index, 'error');
  await staysHidden(5500, 'old speech callbacks cannot restore cleared reply');
  check('clear/hide prevents old speech callbacks or deadlines from restoring the bubble');

  const runtime = await controls.evaluate(() => window.desktop.getRuntimeState());
  assert.equal(runtime.voiceInput, false); assert.equal(runtime.screenSharing, false); assert.equal(runtime.cameraSharing, false);
  const audio = await controls.evaluate(() => window.desktop.getSystemAudioState?.());
  if (audio) assert.equal(audio.active, false);
  const mocks = { controls: await speechState(controls), pet: await speechState(pet) };
  assert.equal(mocks.controls.cloudEvents + mocks.pet.cloudEvents, 0);
  assert.deepEqual((await nativeState()).blockedRequests, []); assert.deepEqual(errors, []);
  report = { status: 'PASS', checks, timings, requests, mocks, inactiveCardRevision, errors, packaged: start.packaged,
    mockAudio: true, acousticPlaybackValidated: false, realDevicesUsed: false, externalAiUsed: false, normalProfileUsed: false, desktopCaptured: false };
} catch (error) {
  const windows = await Promise.all([['controls', controls], ['pet', pet]].map(async ([name, page]) => ({ name,
    state: await page?.evaluate(() => ({ status: document.getElementById('pet-status')?.textContent ?? document.getElementById('stage-status')?.textContent,
      chat: document.getElementById('chat-state')?.textContent, toast: document.getElementById('toast')?.textContent,
      speech: window.__softReplySpeechMock?.snapshot() })).catch(() => null) })));
  report = { status: 'FAIL', checks, timings, requests, errors, windows, failure: error.stack || String(error), mockAudio: true };
  console.error(error); process.exitCode = 1;
} finally {
  try { await closeOwnedApp(); } catch (error) { errors.push(`owned app close: ${error.message}`); appClosed = false; }
  const fakeClaude = claude ? await claude.close() : null;
  if (claude && !(fakeClaude.fakeClaudeExited && fakeClaude.claudeHomeEmpty)) errors.push('fake Claude Code did not exit cleanly');
  if (claude) for (const problem of claude.errors) errors.push(`fake Claude Code: ${problem}`);
  let profileRemoved = false;
  try {
    if (temporary && appClosed) {
      const resolved = await realpath(temporary), root = await realpath(os.tmpdir());
      assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('soft-reply-speech-e2e-'));
      assert.equal((await lstat(temporary)).isSymbolicLink(), false);
      await rm(resolved, { recursive: true, force: true }); profileRemoved = true;
    }
  } catch (error) { errors.push(`temporary profile cleanup: ${error.message}`); }
  report ??= { status: 'FAIL', checks, timings, requests, errors, mockAudio: true };
  report.cleanup = { appClosed, fakeClaude, profileRemoved };
  if (errors.length || !appClosed || !profileRemoved) { report.status = 'FAIL'; report.errors = errors; process.exitCode = 1; }
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`RESULT ${report.status}: ${checks.length} groups; mock audio only; report ${path.join(output, 'report.json')}`);
}
